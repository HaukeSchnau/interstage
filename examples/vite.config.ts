import { resolve } from 'node:path'
import interstage from 'interstage/vite'
import typegpu from 'unplugin-typegpu/vite'
import { defineConfig } from 'vite'

const pages = ['slime/index']

export default defineConfig({
  base: './',
  plugins: [interstage(), typegpu()],
  build: {
    target: 'es2023',
    rollupOptions: {
      input: Object.fromEntries(pages.map((page) => [page, resolve(import.meta.dirname, `${page}.html`)])),
    },
  },
})
