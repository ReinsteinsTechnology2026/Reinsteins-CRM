import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// One id per production build. It is compiled into the bundle (__BUILD_ID__) and also
// published as /version.json, so a tab running an older bundle can notice a newer
// deploy and reload once -- see src/utils/buildVersion.js for why that is needed.
const BUILD_ID = Date.now().toString(36)

const buildVersionFile = () => ({
  name: 'build-version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId: BUILD_ID }) })
  },
})

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react(), buildVersionFile()],
  define: {
    __BUILD_ID__: JSON.stringify(command === 'build' ? BUILD_ID : 'dev'),
  },
}))
