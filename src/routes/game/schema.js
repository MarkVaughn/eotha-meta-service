export const getSessionSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        playerId: { type: 'string' },
        rtseHost: { type: 'string' },
        connected: { type: 'boolean' },
        updatedAt: { type: 'string' }
      }
    }
  }
};

export const createSessionSchema = {
  body: {
    type: 'object',
    properties: {
      rtseHost: { type: 'string' }
    }
  },
  response: {
    200: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        playerId: { type: 'string' },
        rtseHost: { type: 'string' },
        connected: { type: 'boolean' },
        updatedAt: { type: 'string' }
      }
    }
  }
};
