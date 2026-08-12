import { defineConfig } from 'vitest/config'

export default defineConfig({
  // GitHub Pages раздаёт проект из подпути /<repo>/ — правится под реальное имя репозитория.
  base: './',
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
  test: {
    globals: true,
    // Логика намеренно не трогает DOM: всё, что нужно тестам (WebCrypto,
    // CompressionStream, TextEncoder), есть в Node 18+ как глобалы.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
