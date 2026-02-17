{ pkgs ? import (builtins.fetchGit { #
    url = "https://github.com/NixOS/nixpkgs";
    ref = "refs/heads/master";  # Pin to a specific commit or branch
  }) { system = "aarch64-darwin"; } }:

let
  bold = "e[1m";
  green = "e[32m";
  cyan = "e[36m";
  reset = "e[0m";
in
pkgs.mkShell {
  # Specify the environment packages (Node.js and Yarn)
  buildInputs = [
    pkgs.bun
    pkgs.dprint
  ];

shellHook = ''
    # Set some color codes for text styling

    # Generate ASCII art using figlet

    # Print with colors and ASCII art
    echo -e "\${green}\${bold}$(figlet "Imposters")\${reset}"
  '';
}
