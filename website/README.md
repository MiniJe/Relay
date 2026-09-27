# Relay marketing website

Standalone static website; no application dependencies or build-time package installation required.

```sh
cd website
npm install
npm run dev
```

Open http://localhost:4173. Set `PORT` to change the port. `npm run build` and `npm test` run the static content and local-link checks. The HTML and CSS are the deployable assets; host them on any static host. The small Node server is for local preview only.

Product claims are tracked in `../docs/website/CONTENT-SOURCES.md`.
