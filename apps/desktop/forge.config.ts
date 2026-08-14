// Declarative target retained for the signed/unsigned installer milestone.
// The Forge CLI is intentionally not installed yet: Forge 7.11.2 currently
// pulls a git subdependency rejected by this repository's dependency policy.
const config = {
  packagerConfig: {
    appBundleId: 'org.creativeloop2rsi.studio',
    appCategoryType: 'public.app-category.productivity',
    asar: true,
    executableName: 'creative-rsi-studio',
    name: 'Creative RSI Studio',
    osxSign: false,
    osxNotarize: false,
    prune: true,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: { format: 'ULFO' },
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'creative_rsi_studio',
        setupExe: 'Creative-RSI-Studio-Setup.exe',
        noMsi: true,
      },
    },
  ],
}

export default config
