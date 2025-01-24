# Contributing to BCTS API

We love your input! We want to make contributing to BCTS API as easy and transparent as possible, whether it's:
- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features

## Development Standards

We follow the standard NestJS project conventions and best practices:

### Code Style & Linting

- We use ESLint with the default NestJS configuration
- The project extends `@nestjs/eslint-config` and `prettier`
- Run `npm run lint` to check your code style
- Run `npm run format` to automatically format your code

```json
// .eslintrc.js example
{
  "parser": "@typescript-eslint/parser",
  "extends": ["plugin:@typescript-eslint/recommended"],
  "parserOptions": {
    "ecmaVersion": 2020,
    "sourceType": "module"
  }
}
```

### Testing

We maintain high test coverage using the following practices:
- Unit Tests: Use Jest (NestJS default testing framework)
- E2E Tests: Use SuperTest with Jest
- Test files should be placed next to the code they test with the `.spec.ts` suffix
- Run tests using:
  - `npm run test` - unit tests
  - `npm run test:e2e` - end-to-end tests
  - `npm run test:cov` - test coverage

### Git Commit Style

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, missing semi-colons, etc)
- `refactor`: Code refactoring
- `test`: Adding missing tests
- `chore`: Changes to the build process or auxiliary tools

Example:
```
feat(auth): implement JWT authentication
```

### Branch Naming

- Feature branches: `feature/description`
- Bug fixes: `fix/description`
- Documentation: `docs/description`

### Pull Request Process

1. Update the README.md with details of changes if needed
2. Update the CHANGELOG.md following the conventional commits format
3. Ensure all tests pass and new code has adequate test coverage
4. The PR must be approved by at least one maintainer

### Development Environment Setup

1. Install dependencies:
```bash
npm install
```

2. Copy the example environment file:
```bash
cp .env.example .env
```

3. Run the development server:
```bash
npm run start:dev
```

### Code Architecture

- Follow NestJS modular architecture
- Keep modules focused and single-responsibility
- Use dependency injection and avoid tight coupling
- Follow SOLID principles
- Document public APIs using Swagger decorators

## Questions or Suggestions?

Feel free to open an issue or submit a pull request if you have any questions or suggestions for improving these guidelines.
