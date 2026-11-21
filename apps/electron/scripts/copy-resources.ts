import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const appDir = resolve(import.meta.dir, '..')
const source = resolve(appDir, 'resources')
const destination = resolve(appDir, 'dist', 'resources')

if (!existsSync(source)) process.exit(0)
mkdirSync(destination, { recursive: true })
cpSync(source, destination, { recursive: true })
console.log('[build:resources] copied resources -> dist/resources')
