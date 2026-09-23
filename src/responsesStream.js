import crypto from 'node:crypto';

export function rid(prefix) {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

// Writes an OpenAI Responses API event stream in the shape Codex parses
// (codex-rs/codex-api/src/sse/responses.rs).
export class ResponsesStream {
  constructor(res, { model }) {
    this.res = res;
    this.model = model;
    this.id = rid('resp_ccb_');
    this.seq = 0;
    this.outputIndex = 0;
    this.output = [];
    this.open = null; // { kind: 'message'|'reasoning', item, text }
    this.closed = false;
    this.createdAt = Math.floor(Date.now() / 1000);
  }

  begin() {
    this.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    this.send('response.created', { response: this.responseObject('in_progress') });
    this.send('response.in_progress', { response: this.responseObject('in_progress') });
  }

  responseObject(status, extra = {}) {
    return {
      id: this.id,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output: status === 'in_progress' ? [] : this.output,
      ...extra,
    };
  }

  send(type, payload) {
    if (this.closed || this.res.writableEnded || this.res.destroyed) return;
    const data = JSON.stringify({ type, sequence_number: this.seq++, ...payload });
    this.res.write(`event: ${type}\ndata: ${data}\n\n`);
  }

  keepAlive() {
    this.send('response.in_progress', { response: this.responseObject('in_progress') });
  }

  // ---- assistant text ------------------------------------------------------
  textDelta(delta) {
    if (!delta) return;
    if (this.open?.kind !== 'message') {
      this.closeOpen('commentary');
      const item = { id: rid('msg_ccb_'), type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      this.open = { kind: 'message', item, text: '' };
      this.send('response.output_item.added', { output_index: this.outputIndex, item });
      this.send('response.content_part.added', {
        item_id: item.id,
        output_index: this.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    this.open.text += delta;
    this.send('response.output_text.delta', {
      item_id: this.open.item.id,
      output_index: this.outputIndex,
      content_index: 0,
      delta,
    });
  }

  hasOpenMessage() {
    return this.open?.kind === 'message';
  }

  // ---- reasoning (thinking + tool activity) ---------------------------------
  reasoningDelta(delta, { marker } = {}) {
    if (!delta) return;
    if (this.open?.kind !== 'reasoning') {
      this.closeOpen('commentary');
      const item = { id: rid('rs_ccb_'), type: 'reasoning', summary: [], encrypted_content: marker ?? null };
      this.open = { kind: 'reasoning', item, text: '' };
      this.send('response.output_item.added', { output_index: this.outputIndex, item });
      this.send('response.reasoning_summary_part.added', {
        item_id: item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
    this.open.text += delta;
    this.send('response.reasoning_summary_text.delta', {
      item_id: this.open.item.id,
      output_index: this.outputIndex,
      summary_index: 0,
      delta,
    });
  }

  // A complete one-shot reasoning item (used for tool activity lines).
  reasoning(text, opts) {
    this.closeOpen('commentary');
    this.reasoningDelta(text, opts);
    this.closeOpen('commentary');
  }

  // Invisible item carrying the session marker so the next request can be matched.
  marker(marker) {
    this.closeOpen('commentary');
    const item = { id: rid('rs_ccb_'), type: 'reasoning', summary: [], encrypted_content: marker };
    this.send('response.output_item.added', { output_index: this.outputIndex, item });
    this.send('response.output_item.done', { output_index: this.outputIndex, item });
    this.output.push(item);
    this.outputIndex++;
  }

  // ---- native web search cards --------------------------------------------
  webSearchStart(action) {
    this.closeOpen('commentary');
    const item = { id: rid('ws_ccb_'), type: 'web_search_call', status: 'in_progress', action };
    this.send('response.output_item.added', { output_index: this.outputIndex, item });
    const handle = { item, outputIndex: this.outputIndex };
    this.outputIndex++;
    return handle;
  }

  webSearchDone(handle) {
    const item = { ...handle.item, status: 'completed' };
    this.send('response.output_item.done', { output_index: handle.outputIndex, item });
    this.output.push(item);
  }

  compaction(encryptedContent) {
    this.closeOpen('commentary');
    const item = { id: rid('cmp_ccb_'), type: 'compaction', encrypted_content: encryptedContent };
    this.send('response.output_item.added', { output_index: this.outputIndex, item });
    this.send('response.output_item.done', { output_index: this.outputIndex, item });
    this.output.push(item);
    this.outputIndex++;
  }

  // ---- closing ---------------------------------------------------------------
  closeOpen(phase) {
    const o = this.open;
    if (!o) return;
    this.open = null;
    if (o.kind === 'message') {
      const content = [{ type: 'output_text', text: o.text, annotations: [] }];
      this.send('response.output_text.done', {
        item_id: o.item.id,
        output_index: this.outputIndex,
        content_index: 0,
        text: o.text,
      });
      this.send('response.content_part.done', {
        item_id: o.item.id,
        output_index: this.outputIndex,
        content_index: 0,
        part: content[0],
      });
      const item = { ...o.item, status: 'completed', content, phase };
      this.send('response.output_item.done', { output_index: this.outputIndex, item });
      this.output.push(item);
    } else {
      this.send('response.reasoning_summary_text.done', {
        item_id: o.item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        text: o.text,
      });
      this.send('response.reasoning_summary_part.done', {
        item_id: o.item.id,
        output_index: this.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text: o.text },
      });
      const item = { ...o.item, summary: [{ type: 'summary_text', text: o.text }] };
      this.send('response.output_item.done', { output_index: this.outputIndex, item });
      this.output.push(item);
    }
    this.outputIndex++;
  }

  complete(usage) {
    this.closeOpen('final_answer');
    this.send('response.completed', {
      response: this.responseObject('completed', { usage, end_turn: true }),
    });
    this.end();
  }

  // Non-retryable failure (Codex retries server errors, which would re-run Claude).
  fail(message) {
    this.closeOpen('commentary');
    this.send('response.failed', {
      response: this.responseObject('failed', { error: { code: 'invalid_prompt', message } }),
    });
    this.end();
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    if (!this.res.writableEnded) this.res.end();
  }
}

export function usageObject({ input = 0, cached = 0, output = 0 } = {}) {
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}
