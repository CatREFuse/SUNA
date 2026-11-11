# SUNA

SUNA is a desktop application for managing multiple conversational roles, conversations, channels, plugins, tools, memory, and scheduled work. This public source snapshot contains generic starter prompts and a blank starter role. It does not include personal role profiles, account data, local test records, source snapshots, bundled runtimes, or licensed character assets.

## Requirements

- Node.js 24 or newer
- npm
- For desktop packaging: an official, compatible DSH and Node runtime under `runtime/dsh`; macOS packaging also requires the supported NapCat runtime under `runtime/napcat`

The runtime directories and Live2D Cubism Core/model resources are not included. Install only resources you are entitled to use. The application can run its web development build without Live2D assets.

## Development

```sh
npm ci
npm run dev:web
```

`npm run dev` starts the desktop development app and renderer. `npm run build` type-checks the application and creates the renderer bundle in `dist/`.

## Packaging

`npm run package` expects the required official runtime assets and a build host for the target platform. `npm run package:channels` creates plugin archives from the included channel plugin sources.

## Included assets

- Boxicons Vue assets are covered by the included MIT license file.
- Sample preview photos are credited in `public/mockup/avatars/CREDITS.md` and used under the Unsplash License.
- QQ and WeChat brand asset source notes are in `public/brands/SOURCES.md`.
- Live2D Cubism Core is proprietary and is not included. See `public/vendor/live2d/NOTICE.md`.

No separate project license is supplied in this source snapshot.
