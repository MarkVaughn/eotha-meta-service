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

export const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string' },
      password: { type: 'string' }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        player: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            callsign: { type: 'string' }
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
      latitude: { type: 'string', default: '37.7749', pattern: '^-?\\d+(\\.\\d+)?$' },
      longitude: { type: 'string', default: '-122.4194', pattern: '^-?\\d+(\\.\\d+)?$' },
      h3: { type: 'string', default: '8828308281fffff', maxLength: 15 }
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
                      healthPct: { type: 'integer' }
                    }
                  }
                },
                ship_attributes: { type: 'object', additionalProperties: { type: 'number' } }
              }
            },
            spawn_point: {
              type: 'object',
              properties: {
                latitude: { type: 'number' },
                longitude: { type: 'number' },
                h3_index: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }
};
