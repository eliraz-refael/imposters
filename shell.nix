# Pinned for reproducibility. `ref` alone tracked nixpkgs master, so the bun
# version drifted with whenever the fetch cache last refreshed. Bump `rev`
# deliberately when you want a newer toolchain, and keep the `packageManager`
# field in package.json matching the bun version this rev provides.
{ pkgs ? import (builtins.fetchGit {
    url = "https://github.com/NixOS/nixpkgs";
    ref = "refs/heads/master";
    rev = "1ce428abc77bd3f7dd7ae615d9e381cf081990fd"; # bun 1.3.13
  }) { } }:

pkgs.mkShell {
  buildInputs = [
    pkgs.bun
    pkgs.dprint
    pkgs.figlet
  ];

  shellHook = ''
    printf '\033[1;32m'
    figlet "Imposters"
    printf '\033[0m'
    echo "bun $(bun --version)  |  node $(node --version 2>/dev/null || echo 'not in shell')"
  '';
}
