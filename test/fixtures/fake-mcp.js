import readline from 'node:readline';

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  const result = request.method === 'tools/list'
    ? { tools: [{ name: 'js' }, { name: 'js_add_node_module_dir' }, { name: 'turn_ended' }] }
    : request.params?._meta || null;
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
