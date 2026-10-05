import { LINK_REWARD_CREDITS } from '../config/auth.js';

/**
 * Grants the one-time account-linking reward. The reward row's primary key is the player id, so
 * `ON CONFLICT DO NOTHING` makes a repeat (retry, concurrent request, second provider) a no-op, and
 * the credit increment only runs when this call inserted the row. Pass a transaction client so the
 * grant commits atomically with the link itself.
 */
export async function grantLinkReward(tx, playerId, provider) {
  const { count } = await tx.accountLinkReward.createMany({
    data: [{ playerId, provider, credits: LINK_REWARD_CREDITS }],
    skipDuplicates: true
  });
  if (count === 0) return { granted: false, credits: 0 };
  await tx.player.update({ where: { id: playerId }, data: { credits: { increment: LINK_REWARD_CREDITS } } });
  return { granted: true, credits: LINK_REWARD_CREDITS };
}

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
 * account row exists on the player, the guest is promoted and rewarded in one transaction.
 */
export const linkExternalAccount = (prisma) => async ({ userId, provider }) => {
  await prisma.$transaction(async (tx) => {
    await convertGuest(tx, userId);
    await grantLinkReward(tx, userId, provider);
  });
};
