/**
 * The single seam for pre-publish checks on paste content. Task 20 adds the secret scan and the edit
 * rate limit here; every create/edit path calls it before writing. A no-op for now.
 */
export async function validateForPublish(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _content: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: { userId: string; action: 'create' | 'update' },
): Promise<void> {}
