import { createContext } from "react";
import type React from "react";

import type { MenuEntry } from "../../view/ui";

/*
 * What the page around a spec adds to the spec's view (SddRunView.tsx),
 * without the view knowing the page: the box over the document that says
 * what waits for you, and items at the end of the header's ⋯ menu - the
 * spec's older chats. The page's SddEditor.tsx provides it. Nothing
 * provided: the view draws without them.
 */
export interface SpecPageExtras {

    /** Drawn over the document, above everything else of the phase. */
    box?: React.ReactNode;

    /** Added at the end of the header's ⋯ menu. */
    menu?: MenuEntry[];
}

export const SpecPageContext = createContext<SpecPageExtras>({});
