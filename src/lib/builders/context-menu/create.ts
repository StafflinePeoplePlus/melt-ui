import { usePopper } from '$lib/internal/actions/popper';
import {
	addEventListener,
	builder,
	createElHelpers,
	derivedWithUnsubscribe,
	effect,
	executeCallbacks,
	getNextFocusable,
	getPreviousFocusable,
	isHTMLElement,
	kbd,
	FIRST_LAST_KEYS,
	noop,
	styleToString,
	isLeftClick,
	toWritableStores,
	overridable,
} from '$lib/internal/helpers';
import type { Defaults } from '$lib/internal/types';
import type { VirtualElement } from '@floating-ui/core';
import { tick } from 'svelte';
import { get, writable, type Readable } from 'svelte/store';
import {
	applyAttrsIfDisabled,
	clearTimerStore,
	createMenuBuilder,
	getMenuItems,
	handleMenuNavigation,
	handleTabNavigation,
	type Point,
	type MenuParts,
	setMeltMenuAttribute,
} from '../menu';
import type { CreateContextMenuProps } from './types';

const defaults = {
	arrowSize: 8,
	positioning: {
		placement: 'bottom-start',
	},
	preventScroll: true,
	loop: false,
	dir: 'ltr',
	defaultOpen: false,
	closeOnEscape: true,
	closeOnOutsideClick: true,
} satisfies Defaults<CreateContextMenuProps>;

const { name, selector } = createElHelpers<MenuParts>('context-menu');

export function createContextMenu(props?: CreateContextMenuProps) {
	const withDefaults = { ...defaults, ...props } satisfies CreateContextMenuProps;

	const rootOptions = toWritableStores(withDefaults);
	const { positioning, closeOnOutsideClick } = rootOptions;

	const openWritable = withDefaults.open ?? writable(withDefaults.defaultOpen);
	const rootOpen = overridable(openWritable, withDefaults?.onOpenChange);
	const rootActiveTrigger = writable<HTMLElement | null>(null);
	const nextFocusable = writable<HTMLElement | null>(null);
	const prevFocusable = writable<HTMLElement | null>(null);

	const {
		item,
		checkboxItem,
		arrow,
		createSubmenu,
		createMenuRadioGroup,
		rootIds,
		separator,
		handleTypeaheadSearch,
	} = createMenuBuilder({
		rootOpen,
		rootActiveTrigger,
		rootOptions,
		nextFocusable,
		prevFocusable,
		disableFocusFirstItem: true,
		disableTriggerRefocus: true,
		selector: 'context-menu',
	});

	const point = writable<Point | null>(null);
	const virtual: Readable<VirtualElement | null> = derivedWithUnsubscribe([point], ([$point]) => {
		if ($point === null) return null;

		return {
			getBoundingClientRect: () =>
				DOMRect.fromRect({
					width: 0,
					height: 0,
					...$point,
				}),
		};
	});
	const longPressTimer = writable(0);

	function handleClickOutside(e: PointerEvent) {
		if (e.defaultPrevented) return;
		if (e.defaultPrevented) return;
		const target = e.target;
		if (!isHTMLElement(target)) return;

		if (target.id === rootIds.trigger && isLeftClick(e)) {
			rootOpen.set(false);
			return;
		}

		if (target.id !== rootIds.trigger && !target.closest(selector())) {
			rootOpen.set(false);
		}
	}

	const menu = builder(name(), {
		stores: [rootOpen, rootActiveTrigger],
		returned: ([$rootOpen, $rootActiveTrigger]) => {
			// We only want to render the menu when it's open and has an active trigger.
			const ready = $rootOpen && $rootActiveTrigger;
			return {
				role: 'menu',
				hidden: ready ? undefined : true,
				style: styleToString({
					display: ready ? undefined : 'none',
				}),
				id: rootIds.menu,
				'aria-labelledby': rootIds.trigger,
				'data-state': ready ? 'open' : 'closed',
				tabindex: -1,
			} as const;
		},
		action: (node: HTMLElement) => {
			let unsubPopper = noop;

			const unsubDerived = effect(
				[rootOpen, rootActiveTrigger, positioning, closeOnOutsideClick],
				([$rootOpen, $rootActiveTrigger, $positioning, $closeOnOutsideClick]) => {
					unsubPopper();
					if (!($rootOpen && $rootActiveTrigger)) return;
					tick().then(() => {
						setMeltMenuAttribute(node, selector);
						const $virtual = get(virtual);
						const popper = usePopper(node, {
							anchorElement: $virtual ? $virtual : $rootActiveTrigger,
							open: rootOpen,
							options: {
								floating: $positioning,
								clickOutside: $closeOnOutsideClick
									? {
											handler: handleClickOutside,
									  }
									: null,
							},
						});
						if (!popper || !popper.destroy) return;
						unsubPopper = popper.destroy;
					});
				}
			);

			const unsubEvents = executeCallbacks(
				addEventListener(node, 'keydown', (e) => {
					const target = e.target;
					const menuEl = e.currentTarget;
					if (!isHTMLElement(target) || !isHTMLElement(menuEl)) return;

					/**
					 * Submenu key events bubble through portals and
					 * we only care about key events that happen inside this menu.
					 */
					const isKeyDownInside = target.closest("[role='menu']") === menuEl;
					if (!isKeyDownInside) return;
					if (FIRST_LAST_KEYS.includes(e.key)) {
						handleMenuNavigation(e);
					}

					/**
					 * Menus should not be navigated using tab, so we prevent it.
					 * @see https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/#kbd_general_within
					 */
					if (e.key === kbd.TAB) {
						e.preventDefault();
						rootActiveTrigger.set(null);
						rootOpen.set(false);
						handleTabNavigation(e, nextFocusable, prevFocusable);
						return;
					}

					/**
					 * Check for typeahead search and handle it.
					 */
					const isCharacterKey = e.key.length === 1;
					const isModifierKey = e.ctrlKey || e.altKey || e.metaKey;
					if (!isModifierKey && isCharacterKey) {
						handleTypeaheadSearch(e.key, getMenuItems(menuEl));
					}
				})
			);
			return {
				destroy() {
					unsubDerived();
					unsubEvents();
					unsubPopper();
				},
			};
		},
	});

	const trigger = builder(name('trigger'), {
		stores: rootOpen,
		returned: ($rootOpen) => {
			return {
				'aria-controls': rootIds.menu,
				'aria-expanded': $rootOpen,
				'data-state': $rootOpen ? 'open' : 'closed',
				id: rootIds.trigger,
				style: styleToString({
					WebkitTouchCallout: 'none',
				}),
			} as const;
		},
		action: (node: HTMLElement) => {
			applyAttrsIfDisabled(node);

			const handleOpen = (e: MouseEvent | PointerEvent) => {
				point.set({
					x: e.clientX,
					y: e.clientY,
				});
				nextFocusable.set(getNextFocusable(node));
				prevFocusable.set(getPreviousFocusable(node));
				rootActiveTrigger.set(node);
				rootOpen.set(true);
			};

			const unsubTimer = () => {
				clearTimerStore(longPressTimer);
			};

			const unsub = executeCallbacks(
				addEventListener(node, 'contextmenu', (e) => {
					/**
					 * Clear the long press because some platforms already
					 * fire a contextmenu event on long press.
					 */
					clearTimerStore(longPressTimer);
					handleOpen(e);
					e.preventDefault();
				}),
				addEventListener(node, 'pointerdown', (e) => {
					if (!isTouchOrPen(e)) return;

					// Clear the long press in case there's multiple touchpoints
					clearTimerStore(longPressTimer);

					longPressTimer.set(window.setTimeout(() => handleOpen(e), 700));
				}),
				addEventListener(node, 'pointermove', (e) => {
					if (!isTouchOrPen(e)) return;

					clearTimerStore(longPressTimer);
				}),
				addEventListener(node, 'pointercancel', (e) => {
					if (!isTouchOrPen(e)) return;

					clearTimerStore(longPressTimer);
				}),
				addEventListener(node, 'pointerup', (e) => {
					if (!isTouchOrPen(e)) return;

					clearTimerStore(longPressTimer);
				})
			);

			return {
				destroy() {
					unsubTimer();
					unsub();
				},
			};
		},
	});

	return {
		elements: {
			menu,
			trigger,
			item,
			checkboxItem,
			arrow,
			separator,
		},
		states: {
			open: rootOpen,
		},
		builders: {
			createSubmenu,
			createMenuRadioGroup,
		},
		options: rootOptions,
	};
}

/**
 * Check if the event is a touch or pen event
 * @param e The pointer event
 */
function isTouchOrPen(e: PointerEvent) {
	return e.pointerType !== 'mouse';
}
