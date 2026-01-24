# Contributing to SDOC

Thank you for your interest in contributing to SDOC!

## Development Setup

1. Clone the repository:
```bash
git clone https://github.com/entropicwarrior/sdoc.git
cd sdoc
```

2. Install dependencies (none required for core functionality):
```bash
npm install
```

3. Run tests:
```bash
npm test
```

## Project Structure

```
sdoc/
├── src/              # Source code
│   ├── parser.js     # SDOC parser
│   ├── renderer.js   # HTML renderer
│   ├── cli.js        # Command-line tool
│   └── index.js      # Main exports
├── test/             # Test files
│   ├── parser.test.js
│   └── renderer.test.js
├── examples/         # Example SDOC files
├── vscode-extension/ # VSCode syntax highlighting
└── SPEC.md          # Format specification

```

## Making Changes

1. Create a new branch:
```bash
git checkout -b feature/your-feature-name
```

2. Make your changes

3. Add tests for new features

4. Run tests to ensure everything works:
```bash
npm test
```

5. Commit your changes:
```bash
git commit -m "Description of changes"
```

6. Push and create a pull request

## Areas for Contribution

- **New block types**: Add support for tables, images, etc.
- **Output formats**: Add PDF, Markdown, or JSON renderers
- **Editor support**: Create plugins for other editors (Vim, Sublime, etc.)
- **Performance**: Optimize parser and renderer
- **Documentation**: Improve examples and guides
- **Bug fixes**: Fix any issues you find

## Code Style

- Use ES6 modules
- Write clear, descriptive variable names
- Add comments for complex logic
- Keep functions focused and small
- Follow existing code patterns

## Testing

- Write tests for new features
- Ensure all tests pass before submitting PR
- Test with example files

## Questions?

Feel free to open an issue for any questions or discussions!
