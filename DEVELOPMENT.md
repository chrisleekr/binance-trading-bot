# Development

This document describes the process for running this application on your local computer.

## Getting started

This application is powered by Node.js & Docker compose!

It runs on macOS, and Linux environments. I did not test or run this application on Windows environment.

You'll need Node.js version 14. To install Node.js, [download the "LTS" installer from nodejs.org](https://nodejs.org). If you're using [`nodenv`](https://github.com/nodenv/nodenv), read the [`nodenv` docs](#nodenv) for instructions on switching Node.js versions.

In addition, you will need Docker Compose. To install Docker Compose, [refer steps from docker.com](https://docs.docker.com/compose/install/).

Once you've installed Node.js and Docker Compose, open Terminal and run the following:

```sh
git clone https://github.com/chrisleekr/binance-trading-bot
npm install
docker-compose up -d --build
```

You should now have a running server! Visit [localhost:8080](http://localhost:8080) in your browser. Unfortunately, it does not automatically refresh the change. Please refresh the browser to see the change.

When you're ready to stop your local server, run the following:

```sh
docker-compose down
```

## Branch naming conventions

The project enforces the branch name.

```text
  <type>/<branch name>
     │      │
     |      └─> Summary in present tense. Not capitalized. No period at the end.
     |
     └─> Type: chore, docs, feat, fix, refactor, style, or test.
```

### Example

```text
  feat/new-feature
  fix/the-bug
  docs/readme
  style/update-button
  refactor/change-variable
  test/add-test
  chore/some-small-thing
  perf/improve-performance
  build/update-build-step
  ci/update-ci
  revert/revert-commit
  localize/add-korean-translation
  bump/bump-version
```

| type        | description       |
| ----------- | ----------------- |
| `build`     | Changes that affect the build system or external dependencies (example scopes: gulp, broccoli, npm) |
| `ci`        | Changes to our CI configuration files and scripts (example scopes: Travis, Circle, BrowserStack, SauceLabs) |
| `chore`     | Updating grunt tasks etc; no production code change, Other changes that don't modify src or test files |
| `docs`      | Changes to the documentation |
| `feat`      | New feature for the user, not a new feature for build script |
| `fix`       | Bug fix for the user, not a fix to a build script |
| `perf`      | A code change that improves performance |
| `refactor`  | Refactoring production code, eg. renaming a variable, A code change that neither fixes a bug nor adds a feature |
| `revert`    | Reverts a previous commit |
| `style`     | Formatting, missing semi colons, etc. (white-space, formatting, missing semi-colons, changes that do not affect the meaning of the code, etc); no production code change |
| `test`      | Adding missing tests, refactoring tests; no production code change |

## Commit message conventions

The project enforces commit message conventions. To know what patterns to use, please visit [commitlint](https://github.com/conventional-changelog/commitlint/#what-is-commitlint) and [conventional commits](https://www.conventionalcommits.org/en/v1.0.0/)

```text
  type(scope?): description  #scope is optional; multiple scopes are supported (current delimiter options: "/", "\" and ",")

  [optional body]

  [optional footer(s)]
```

Allowed types are:

- `build`
- `ci`
- `chore`
- `docs`
- `feat`
- `fix`
- `perf`
- `refactor`
- `revert`
- `style`
- `test`
