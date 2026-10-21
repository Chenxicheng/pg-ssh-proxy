export class PromptQueue {
  #tail = Promise.resolve();

  run<T>(prompt: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(prompt);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
