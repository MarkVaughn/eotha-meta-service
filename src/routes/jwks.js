// Publishes the Ed25519 public key that verifies every access token (RFC 7517 JWK Set).
export default async function jwksRoutes(fastify) {
  fastify.get('/.well-known/jwks.json', async (request, reply) => {
    reply.header('cache-control', 'public, max-age=300');
    return fastify.jwks;
  });
}
