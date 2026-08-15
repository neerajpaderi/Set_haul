import 'dotenv/config';
import { createApp } from '../server/app.js';

// Vercel Serverless Function entrypoint — wraps the Express app so every
// /api/* request (see vercel.json rewrite) is handled by the same routes
// used in local dev (server.ts), instead of falling through to the static
// SPA build and 404ing.
export default createApp();
