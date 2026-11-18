import env from './env.js';

// A device id is the guest's credential, so it must be a high-entropy client-generated value (e.g. a UUID).
export const DEVICE_ID_MIN_LENGTH = 16;
export const DEVICE_ID_MAX_LENGTH = 128;

// Credits every account starts with (env ACCOUNT_STARTING_CREDITS, default 500). A new email or Google
// account has them from creation; a guest starts with none and receives them once, when it links an account.
export const ACCOUNT_STARTING_CREDITS = env.ACCOUNT_STARTING_CREDITS;
