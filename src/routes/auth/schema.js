import { DEFAULT_HARBOR } from '../../config/harbor.js';
import { DEVICE_ID_MAX_LENGTH, DEVICE_ID_MIN_LENGTH } from '../../config/auth.js';

export const registerSchema = {
  body: {
    type: 'object',
    required: ['email', 'password', 'callsign', 'latitude', 'longitude', 'h3Index'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 6 },
      callsign: { type: 'string', minLength: 3 },
      latitude: { type: 'number' },
      longitude: { type: 'number' },
      h3Index: { type: 'string', maxLength: 15 }
    }
  },
  response: {
    201: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        callsign: { type: 'string' }
      }
    }
  }
};

const spawnPointSchema = {
  type: 'object',
  properties: {
    latitude: { type: 'number' },
    longitude: { type: 'number' },
    h3_index: { type: 'string' }
  }
};

// Everything a sign-in, guest login or refresh hands back: a short-lived access JWT (the one the
// RTSE verifies), the rotating refresh token, and the access token's lifetime in seconds.
const sessionResponse = {
  type: 'object',
  properties: {
    token: { type: 'string' },
    refreshToken: { type: 'string' },
    expiresIn: { type: 'integer' },
    gateway_ws_url: { type: 'string' },
    created: { type: 'boolean' },
    player: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        callsign: { type: 'string' },
        anonymous: { type: 'boolean' },
        spawn_point: spawnPointSchema
      }
    }
  }
};

export const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password', 'deviceId'],
    properties: {
      email: { type: 'string' },
      password: { type: 'string' },
      deviceId: { type: 'string', minLength: DEVICE_ID_MIN_LENGTH, maxLength: DEVICE_ID_MAX_LENGTH }
    }
  },
  response: { 200: sessionResponse }
};

export const guestSchema = {
  body: {
    type: 'object',
    required: ['deviceId'],
    properties: {
      deviceId: { type: 'string', minLength: DEVICE_ID_MIN_LENGTH, maxLength: DEVICE_ID_MAX_LENGTH }
    }
  },
  response: { 200: sessionResponse }
};

export const googleStartSchema = {
  body: {
    type: ['object', 'null'],
    properties: { returnTo: { type: 'string', maxLength: 512 } }
  },
  response: {
    200: { type: 'object', properties: { url: { type: 'string' } } }
  }
};

export const googleExchangeSchema = {
  body: {
    type: 'object',
    required: ['code'],
    properties: { code: { type: 'string', minLength: 1, maxLength: 128 } }
  },
  response: { 200: sessionResponse }
};

export const refreshSchema = {
  body: {
    type: 'object',
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 256 } }
  },
  response: { 200: sessionResponse }
};

export const logoutSchema = {
  body: {
    type: 'object',
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string', minLength: 1, maxLength: 256 } }
  }
};

export const linkEmailSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 6 },
      callsign: { type: 'string', minLength: 3 }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        expiresIn: { type: 'integer' },
        player: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            callsign: { type: 'string' },
            anonymous: { type: 'boolean' }
          }
        }
      }
    }
  }
};

export const devLoginSchema = {
  querystring: {
    type: 'object',
    properties: {
      callsign: { type: 'string', default: 'DevPilot', minLength: 1 },
      latitude: { type: 'string', default: String(DEFAULT_HARBOR.latitude), pattern: '^-?\\d+(\\.\\d+)?$' },
      longitude: { type: 'string', default: String(DEFAULT_HARBOR.longitude), pattern: '^-?\\d+(\\.\\d+)?$' },
      h3: { type: 'string', default: DEFAULT_HARBOR.h3Index, maxLength: 15 }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        gateway_ws_url: { type: 'string' },
        player: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            callsign: { type: 'string' },
            dev: { type: 'boolean' },
            ship: {
              type: 'object',
              properties: {
                components: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string' },
                      tier: { type: 'integer' },
                      quality: { type: 'string' },
                      healthPct: { type: 'integer' }
                    }
                  }
                },
                ship_attributes: { type: 'object', additionalProperties: { type: 'number' } }
              }
            },
            spawn_point: spawnPointSchema
          }
        }
      }
    }
  }
};
