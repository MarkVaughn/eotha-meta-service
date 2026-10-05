/**
 * Turns a guest into a linked player, keeping the same id. Returns false when the player was
 * not (or no longer) a guest, so concurrent link attempts cannot both win.
 */
export async function convertGuest(tx, playerId, data = {}) {
  const { count } = await tx.player.updateMany({
    where: { id: playerId, isAnonymous: true },
    data: { ...data, isAnonymous: false }
  });
  return count === 1;
}

/**
 * Better Auth hook target for external providers (Apple, Google, Play Games, ...): once their
 * account row exists on the player, the guest is promoted and its guest-only locks lift.
 */
export const linkExternalAccount = (prisma) => async ({ userId }) => {
  await convertGuest(prisma, userId);
};
