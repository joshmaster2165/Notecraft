import { createContext, useContext } from "react";

/** True while a page version is being previewed: everything renders, nothing edits. */
export const ReadOnlyContext = createContext(false);
export const useReadOnly = () => useContext(ReadOnlyContext);
