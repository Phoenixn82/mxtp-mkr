!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$SMPROGRAMS\Mixtape Maker (MXTP MKR).lnk" "$INSTDIR\mxtp-mkr.exe" "" "$INSTDIR\mxtp-mkr.exe" 0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$SMPROGRAMS\Mixtape Maker (MXTP MKR).lnk"
!macroend
