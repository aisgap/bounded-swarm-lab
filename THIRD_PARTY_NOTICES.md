# Third-party notices

Bounded Swarm Lab includes or adapts third-party software. Those components remain under their own licenses.

## Vendored source and assets

- The Sites Vite plugin notice is retained at `scripts/vite/sites-vite-plugin.LICENSE`.
- The shadcn Tailwind stylesheet notice is retained at `vendor/shadcn-tailwind-4.13.0.LICENSE.md`.

Do not remove those files when redistributing source or build artifacts that contain the corresponding material.

## Package dependencies

JavaScript packages declared in `package.json` and `package-lock.json` are not relicensed by this project. Their package metadata and upstream license files govern their use. A distributor of compiled applications, containers, or dependency bundles is responsible for reviewing and carrying forward all notices required by the exact dependency set and target platform.

In particular, do not commit or redistribute `node_modules` as part of this source repository. Perform a fresh dependency-license review before distributing a compiled bundle that embeds optional native binaries or other copyleft-licensed runtime components.

## OpenAI affiliation

This community project uses OpenAI APIs and OpenAI Sites integration points. It is not an official OpenAI product and is not endorsed or supported by OpenAI.
