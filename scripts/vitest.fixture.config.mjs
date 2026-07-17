export default {
  test: {
    environment: "node",
    include: ["scripts/aortaseg-overlap.fixture.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000
  }
};
