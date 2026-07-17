export default {
  test: {
    environment: "node",
    include: ["scripts/dicom-study-budget.fixture.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 240_000
  }
};
