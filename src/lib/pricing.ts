export function estimateCompute(inputTokens: number, outputTokens: number) {
  const inRate = Number(process.env.MODEL_INPUT_USD_PER_MILLION || '0.20');
  const outRate = Number(process.env.MODEL_OUTPUT_USD_PER_MILLION || '1.20');
  const fx = Number(process.env.USD_INR || '88');
  const inputUsd = (inputTokens / 1_000_000) * inRate;
  const outputUsd = (outputTokens / 1_000_000) * outRate;
  const computeInr = (inputUsd + outputUsd) * fx;
  const marginInr = computeInr * 0.10;
  return { inputTokens, outputTokens, inputUsd, outputUsd, computeInr, marginInr, totalInr: computeInr + marginInr };
}
