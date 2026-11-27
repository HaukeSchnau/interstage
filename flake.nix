{
  description = "interstage's toolchain";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    projects-sdk = {
      url = "github:HaukeSchnau/projects-sdk/v0.1.0";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { nixpkgs, projects-sdk, ... }:
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
              toolchain = import ./nix/toolchain.nix {
                inherit pkgs;
                sdk = projects-sdk;
              };
              shell = pkgs.mkShellNoCC {
                packages = builtins.attrValues toolchain ++ [ pkgs.chromium ];
                # The tests and the validate option run shaders on Dawn (the webgpu package), here on
                # Mesa's software Vulkan driver.
                VK_ICD_FILENAMES = "${pkgs.mesa}/share/vulkan/icd.d/lvp_icd.${pkgs.stdenv.hostPlatform.uname.processor}.json";
                LD_LIBRARY_PATH = "${pkgs.vulkan-loader}/lib";
                # examples/scripts/check.ts drives this browser.
                CHROME = "${pkgs.chromium}/bin/chromium";
                # `vp check` type-checks through tsrs-lint, which starts the tsconfigs' content
                # mappers only with this. oxlint passes it no flags.
                TSRS_LINT_RUN_EXTERNAL_CODE = "1";
              };
            in
            {
              ci = shell;
              default = shell;
            }
          );
    };
}
