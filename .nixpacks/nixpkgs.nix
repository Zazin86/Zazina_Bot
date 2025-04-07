{ pkgs ? import <nixpkgs> {} }:

pkgs.mkShell {
  buildInputs = [
    pkgs.nodejs_20  # Указываем нужную версию Node.js (например, 20)
    pkgs.yarn       # Если используете Yarn
  ];
}