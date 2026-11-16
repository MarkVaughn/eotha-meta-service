// Import before ./helpers.js: it puts Sign in with Google (and the demo's public base URL, behind a proxy
// that strips /api) into the environment before the app reads it.
process.env.GOOGLE_CLIENT_ID = 'test-google-client-id.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
process.env.BETTER_AUTH_URL = 'https://demo.eotha.com/api';
