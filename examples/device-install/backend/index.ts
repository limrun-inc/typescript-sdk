import express from 'express';
import cors from 'cors';
import { attachRegistryRelayProxy } from './relay-proxy.js';

const apiKey = process.env['LIM_API_KEY'];
const registryUrl = process.env['LIM_REGISTRY_ENDPOINT'] ?? 'https://registry.limrun.com';

if (!apiKey) {
  console.error('Error: Missing required environment variable (LIM_API_KEY).');
  process.exit(1);
}

const app = express();
const port = 3000;
app.use(cors());

const server = app.listen(port, () => {
  console.log(`Relay proxy listening at http://localhost:${port}`);
});

// Pairing and install run against Limrun's registry. The browser connects to
// this backend, which pipes the WebSocket frames to the registry with the API
// key attached server-side — the key never reaches the browser.
attachRegistryRelayProxy(server, { registryUrl, apiKey, log: console.log });
