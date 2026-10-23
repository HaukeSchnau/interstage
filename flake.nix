{
  description = "interstage's toolchain";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    {
      devShells =
        nixpkgs.lib.genAttrs
          [
            "aarch64-linux"
            "x86_64-linux"
          ]
          (
            system:
            let
              pkgs = nixpkgs.legacyPackages.${system};
              tools = import ./nix/toolchain.nix { inherit pkgs; };
              shell = pkgs.mkShellNoCC {
                packages = [
                  tools.nodejs
                  tools.pnpm
                  pkgs.chromium
                ];
                # The tests and the validate option run shaders on Dawn (the webgpu package), here on
                # Mesa's software Vulkan driver.
                VK_ICD_FILENAMES = "${pkgs.mesa}/share/vulkan/icd.d/lvp_icd.${pkgs.stdenv.hostPlatform.uname.processor}.json";
                LD_LIBRARY_PATH = "${pkgs.vulkan-loader}/lib";
                # examples/scripts/check.ts drives this browser.
                CHROME = "${pkgs.chromium}/bin/chromium";
              };
            in
            {
              ci = shell;
              default = shell;
            }
          );
    };
}
