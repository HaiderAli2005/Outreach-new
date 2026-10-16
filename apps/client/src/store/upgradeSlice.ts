import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

/**
 * The one upgrade prompt. It opens only from the API layer when the server refuses a spend with 402
 * INSUFFICIENT_CREDITS, so no feature has its own "out of credits" handling.
 */
const upgradeSlice = createSlice({
  name: "upgrade",
  initialState: { open: false, message: "" },
  reducers: {
    creditsRefused(state, action: PayloadAction<string>) {
      state.open = true;
      state.message = action.payload;
    },
    upgradeClosed(state) {
      state.open = false;
    },
  },
});

export const { creditsRefused, upgradeClosed } = upgradeSlice.actions;
export default upgradeSlice.reducer;
