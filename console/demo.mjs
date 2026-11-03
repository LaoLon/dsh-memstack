/** Seeds a demo store and starts the console against it, without touching real memory. */

import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDemoState } from './seed-demo.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const demoHome = join(here, '..', '.demo')
const stateFile = join(demoHome, 'memstack', 'state.json')
const port = process.env.MEMSTACK_CONSOLE_PORT ?? '7799'

await mkdir(join(demoHome, 'memstack'), { recursive: true })
await writeFile(stateFile, `${JSON.stringify(createDemoState(), null, 2)}\n`, 'utf8')

console.log(`MemStack demo state: ${stateFile}`)
console.log(`starting console on http://127.0.0.1:${port} (Ctrl+C to stop)`)

const child = spawn(process.execPath, [join(here, 'server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, MEMSTACK_HOME: demoHome, MEMSTACK_CONSOLE_PORT: port },
})
child.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill()
  })
}
