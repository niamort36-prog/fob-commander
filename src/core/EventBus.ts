/**
 * Bus d'événements typé. La map générique M associe chaque nom d'événement à son payload,
 * ce qui garantit à la compilation que l'émetteur et les abonnés parlent du même format.
 */
export class EventBus<M extends object> {
  private handlers = new Map<keyof M, Set<(payload: never) => void>>();

  /** S'abonne ; renvoie une fonction de désabonnement. */
  on<K extends keyof M>(event: K, handler: (payload: M[K]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (payload: never) => void);
    return () => this.off(event, handler);
  }

  off<K extends keyof M>(event: K, handler: (payload: M[K]) => void): void {
    this.handlers.get(event)?.delete(handler as (payload: never) => void);
  }

  emit<K extends keyof M>(event: K, payload: M[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copie : un abonné peut se désabonner pendant l'émission.
    for (const handler of [...set]) {
      try {
        (handler as (p: M[K]) => void)(payload);
      } catch (err) {
        console.error(`[EventBus] erreur dans un abonné à « ${String(event)} »`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
