// Package Syzygy.app. The programmatic API rather than the CLI, so the options
// are readable and nothing depends on how the CLI spells a nested flag.
//
// osxSign with the identity '-' is an AD-HOC signature. It is not a developer
// identity and asks for no permission grant, but it is not optional either: an
// arm64 bundle whose contents have been rewritten carries an invalid signature
// and macOS refuses to launch it. identityValidation is off because a
// keychain lookup would otherwise match '-' as a substring of some other
// identity's name and try to sign with that instead. hardenedRuntime is off
// too: it turns on library validation, which an ad-hoc signature has no team
// id to satisfy, so the framework would refuse to load -- and it can only be
// turned off through optionsForFile, since @electron/osx-sign reads the
// top-level osxSign.hardenedRuntime for nothing at all and always signs each
// file with its own default of true otherwise. The arch follows the machine
// building it rather than a fixed 'arm64'.
//
// NSMicrophoneUsageDescription is here because the pane shows its dictate
// button whenever the relay reports the engine ready -- it cannot know it is
// inside a shell -- and a macOS app that reaches for the microphone without
// this string is terminated by the system rather than refused.
import { packager } from '@electron/packager'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = dirname(fileURLToPath(import.meta.url))

const paths = await packager({
  dir: APP_DIR,
  out: join(APP_DIR, 'dist'),
  name: 'Syzygy',
  appBundleId: 'dev.syzygy.app',
  appVersion: '0.1.0',
  platform: 'darwin',
  arch: process.arch,
  icon: join(APP_DIR, 'dist', 'icon', 'Syzygy.icns'),
  // One PNG per accent, copied into Resources/themes, so the Dock icon can
  // follow the theme the pane is showing.
  extraResource: [join(APP_DIR, 'dist', 'icon', 'themes')],
  overwrite: true,
  prune: true,
  ignore: [/^\/dist($|\/)/, /^\/pack\.mjs$/],
  osxSign: {
    identity: '-',
    identityValidation: false,
    optionsForFile: () => ({ hardenedRuntime: false }),
  },
  extendInfo: {
    NSMicrophoneUsageDescription: 'Dictating a prompt into the Syzygy pane.',
    LSApplicationCategoryType: 'public.app-category.developer-tools',
  },
})

process.stdout.write('packaged: ' + paths.join(', ') + '\n')
