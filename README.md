# pi-modes

Prompt mode switching extension for [pi](https://pi.dev).

## Install

```bash
pi install git:github.com/maximerivest/pi-modes
```

Try once without installing:

```bash
pi -e git:github.com/maximerivest/pi-modes
```

## Commands

- `/mode` - fuzzy-select a prompt mode
- `/mode <key>` - switch to a mode by key
- `/mode-new [key]` - create a custom mode from the TUI
- `/mode-edit [key]` - edit a custom mode
- `/mode-delete [key]` - delete a custom mode

Built-in modes:

- `coding`
- `plan`
- `review`
- `explain`

Custom modes are saved as JSON in `~/.pi/agent/modes/`.

## License

MIT
