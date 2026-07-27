/**
 * Read all of stdin as a UTF-8 string. Both hook entry points
 * (capture-session-model.mjs, enforce-subagent-model.mjs) receive their
 * JSON payload this way; per spec §11 the entry points hold no logic beyond
 * reading stdin, calling into lib/, and writing stdout — this is that one
 * shared piece of plumbing, kept in one place instead of duplicated.
 */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
