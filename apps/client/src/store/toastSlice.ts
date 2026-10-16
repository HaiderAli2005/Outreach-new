import { createSlice, nanoid, type PayloadAction } from "@reduxjs/toolkit";

export type ToastTone = "good" | "bad" | "info";

export interface Toast {
  id: string;
  tone: ToastTone;
  message: string;
}

const toastSlice = createSlice({
  name: "toasts",
  initialState: [] as Toast[],
  reducers: {
    pushToast: {
      reducer(state, action: PayloadAction<Toast>) {
        state.push(action.payload);
        if (state.length > 4) state.shift();
      },
      prepare(message: string, tone: ToastTone = "info") {
        return { payload: { id: nanoid(), tone, message } };
      },
    },
    dismissToast(state, action: PayloadAction<string>) {
      return state.filter((t) => t.id !== action.payload);
    },
  },
});

export const { pushToast, dismissToast } = toastSlice.actions;
export default toastSlice.reducer;
