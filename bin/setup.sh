#!/bin/bash
set -euo pipefail

brew bundle -v

mise trust .config/mise.toml
mise install
mise run install
