import { ACCOUNT_STARTING_CREDITS } from '../config/auth.js';

/**
 * Turns a guest into a linked player, keeping the same id, and grants the account starting credits.
 * It is one guarded UPDATE: the guest conversion, the credit grant and its `accountCreditsGrantedAt`
 * record commit or fail together, so a retry, a double click or a concurrent link can win at most
 * once, and a link that fails (a taken email, say) grants nothing. Returns false when the player was
 * not (or no longer) a guest.
 */
export async function convertGuest(tx, playerId, data = {}) {
  const { count } = await tx.player.updateMany({
    where: { id: playerId, isAnonymous: true },
    data: {
      ...data,
      isAnonymous: false,
      credits: { increment: ACCOUNT_STARTING_CREDITS },
      accountCreditsGrantedAt: new Date()
    }
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
