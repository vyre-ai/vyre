// @ts-check
// builder-plan: the documented command plan a BuildKit builder follows. Nothing here runs a build.
//
// Publish asks a builder module for a build through the tool `builder.build { deployment, secretArgs }` (reach modules).
// A builder that answers it does these steps, in this order, inside the build network of the Publish edge (no route to the
// space's data, registries only):
//   1. fetch the source named by deployment.source (a repo ref or a Drive folder) into a clean directory
//   2. write a Dockerfile from the deployment's build image (static, node-20, node-22) and its build command
//   3. run `buildctl` against the rootless buildkit service with each granted build secret as a `--secret` file
//   4. read the output folder back as the files to publish, and hand back the digest, the log and the runtime
// Secrets reach the build only as files named by secretArgs; they never enter an image layer or the log.
// With no builder installed, Publish says so in plain words and builds nothing.

export const NO_BUILDER = "no builder installed: Publish can plan, approve and publish, but nothing here can build a site yet";

/**
 * The buildctl command line for one deployment. A plan for a builder to run, never run here.
 * @param {{ id: string, build: { image: string, command?: string, output_dir?: string } }} deployment
 * @param {{ secretArgs?: string[], context: string, out: string, addr?: string }} io
 * @returns {string[]} argv, program first
 */
export function buildctlArgs(deployment, io) {
  const secrets = io.secretArgs || [];
  return [
    "buildctl", "--addr", io.addr || "tcp://buildkit:1234", "build",
    "--frontend", "dockerfile.v0",
    "--local", `context=${io.context}`,
    "--local", `dockerfile=${io.context}`,
    "--opt", `build-arg:BUILD_IMAGE=${deployment.build.image}`,
    "--opt", `build-arg:OUTPUT_DIR=${deployment.build.output_dir || "."}`,
    ...secrets,
    "--output", `type=local,dest=${io.out}`,
  ];
}
