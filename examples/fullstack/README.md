# Fullstack Limrun Integration

This example show show you can integrate Limrun instances in your application.

It has two components:
- `backend/`: The calls you need to make in your server with your Limrun API key.
- `frontend/`: How to mount the Limrun `RemoteControl` React component in your frontend
  to stream the created instance.

## Quick Start

1. Get an API Key from `Limrun Console` > `Settings` page [here](https://console.limrun.com/settings).
1. Make it available as environment variable.
   ```bash
   export LIM_API_KEY="you api key"
   ```
1. Start the backend.
   ```bash
   yarn --cwd examples/fullstack/backend install
   yarn --cwd examples/fullstack/backend run start
   ```
1. In another terminal session, start the frontend.
   ```bash
   yarn --cwd examples/fullstack/frontend install
   yarn --cwd examples/fullstack/frontend run dev
   ```
1. Go to `localhost:5173` and create your first instance through your backend!
