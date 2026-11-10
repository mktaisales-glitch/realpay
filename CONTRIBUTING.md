# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Set up

```bash
cp .env.sample .env      # sandbox credentials only
cd server/node
npm install
npm run dev              # restarts on change
```

## Before you open a pull request

```bash
npm run format           # prettier
npm run lint             # eslint (server and client) and tsc
npm test                 # vitest
```

CI runs the same three checks on Node 20 and 24.

## Conventions

- TypeScript ESM with erasable syntax only, so Node can run the sources
  directly. No enums, namespaces or parameter properties.
- Route handlers stay thin: validate with zod, call the milestone
  service, return JSON. Business rules live in `src/domain`.
- Anything that decides whether money moves is a pure function with a
  unit test for every branch (see `releasePolicy.ts`).
- Every new PayPal call needs a deterministic `PayPal-Request-Id`.
- A new niche is a JSON template in `src/templates`, not new code.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org).

## Security

Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
