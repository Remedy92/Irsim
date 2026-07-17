export default {
  test: {
    environment: "node",
    include: ["scripts/jpeg2000-ct.fixture.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000
  }
};
