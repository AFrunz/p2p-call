/**
 * Обвязка над DOM. Фреймворка нет, разметка и код связаны идентификаторами,
 * поэтому пропавший id должен падать сразу, а не отдавать тихий null.
 */

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (node === null) throw new Error(`в разметке нет элемента #${id}`)
  return node as T
}

export function on<K extends keyof HTMLElementEventMap>(
  target: HTMLElement | string,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void,
): void {
  const node = typeof target === 'string' ? el(target) : target
  node.addEventListener(type, handler as EventListener)
}

export function setText(target: HTMLElement | string, text: string): void {
  const node = typeof target === 'string' ? el(target) : target
  node.textContent = text
}

export function show(target: HTMLElement | string, visible: boolean): void {
  const node = typeof target === 'string' ? el(target) : target
  node.hidden = !visible
}

/** Показывает ровно один элемент из набора — остальные прячет. */
export function showOnly(ids: readonly string[], visibleId: string | null): void {
  for (const id of ids) show(id, id === visibleId)
}

export function setPressed(target: HTMLElement | string, pressed: boolean): void {
  const node = typeof target === 'string' ? el(target) : target
  node.setAttribute('aria-pressed', String(pressed))
}

export function setDisabled(target: HTMLElement | string, disabled: boolean, reason = ''): void {
  const node = (typeof target === 'string' ? el(target) : target) as HTMLButtonElement
  node.disabled = disabled
  node.title = disabled ? reason : ''
}

export interface Option {
  value: string
  label: string
}

/** Наполняет `select`, сохраняя выбранное значение, если оно ещё доступно. */
export function fillSelect(target: HTMLSelectElement | string, options: Option[], selected: string): void {
  const node = typeof target === 'string' ? el<HTMLSelectElement>(target) : target

  node.replaceChildren(
    ...options.map((option) => {
      const item = document.createElement('option')
      item.value = option.value
      item.textContent = option.label
      return item
    }),
  )

  node.value = options.some((option) => option.value === selected) ? selected : (options[0]?.value ?? '')
}

/**
 * Подставляет поток в `<video>` и запускает воспроизведение.
 *
 * Атрибута autoplay мало: браузер может отказать в автозапуске со звуком, и
 * тогда элемент молча остаётся на паузе. Об отказе надо знать — иначе он
 * выглядит как «звук не передаётся».
 */
export function attachStream(target: HTMLVideoElement | string, stream: MediaStream | null): void {
  const node = typeof target === 'string' ? el<HTMLVideoElement>(target) : target
  if (node.srcObject === stream) return

  node.srcObject = stream
  if (stream === null) return

  void node.play().catch((error: unknown) => {
    console.debug(
      `[p2p] воспроизведение ${node.id} не запустилось:`,
      error instanceof Error ? error.name : error,
    )
  })
}
