# Contributing

Issues and pull requests are welcome.

## Development

1. Install Node.js 22 and run `npm ci`.
2. Run `npm test`, `npm run lint`, and `npm run build` before submitting a pull request.
3. Keep credentials outside the repository. Live ASR tests read the existing local configuration and must never print or commit secrets.

Keep changes focused and include tests for behavior that can be verified without provider credentials.
