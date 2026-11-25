{ pkgs, sdk }:
import "${sdk}/lib/toolchain.nix" { inherit pkgs; }
// {
  # Releases stage with `npm stage` (Npm.publish in .calder/ci.ts), and nodejs-slim has no npm.
  # The same Node with npm 11.20.
  nodejs = pkgs.nodejs_26;
}
