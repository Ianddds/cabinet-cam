+================================================
+ Test fixture: written in the style of the Vectric ShopBot posts
+ (embedded quotes, tab comments, multipliers, blank prefixes, a
+ FIRST_RAPID_MOVE that leaves Z out) - not a copy of one.
+================================================
POST_NAME = "ShopBot style test (inch)(*.sbp)"
FILE_EXTENSION = "sbp"
UNITS = "INCHES"
DIRECT_OUTPUT = "Output_to_ShopBot|ShopBot3.exe"
SUBSTITUTE = "([91])[93]"
+------------------------------------------------
VAR SPINDLE_SPEED = [S|A||1.0]
VAR CUT_RATE = [FC|A||1.6|0.0166666667]
VAR PLUNGE_RATE = [FP|A||1.6|0.0166666667]
VAR X_POSITION = [X|A||1.6]
VAR Y_POSITION = [Y|A||1.6]
VAR Z_POSITION = [Z|A||1.6]
VAR ARC_CENTRE_I_INC_POSITION = [I|A||1.6]
VAR ARC_CENTRE_J_INC_POSITION = [J|A||1.6]
VAR X_HOME_POSITION = [XH|A||1.6]
VAR Y_HOME_POSITION = [YH|A||1.6]
VAR Z_HOME_POSITION = [ZH|A||1.6]
VAR SAFE_Z_HEIGHT = [SAFEZ|A||1.3]
VAR X_LENGTH = [XLENGTH|A||1.3]
VAR Y_LENGTH = [YLENGTH|A||1.3]
VAR Z_LENGTH = [ZLENGTH|A||1.3]
+------------------------------------------------
begin HEADER
"'SHOPBOT ROUTER FILE IN INCHES"
"'Length of material in X = [XLENGTH]"
"'Length of material in Y = [YLENGTH]"
"'Home Position Information = [XY_ORIGIN], [Z_ORIGIN] "
"IF %(25)=1 THEN GOTO UNIT_ERROR	'check to see software is set to standard"
"SA                             	'Set program to absolute coordinate mode"
"CN, 90"
"'Toolpath Name = [TOOLPATH_NAME]"
"'&ToolName = "[TOOLNAME]""
"&PWSafeZ = [SAFEZ]"
"&Tool =[T]           'Tool number to change to"
"C9                   'Change tool"
"TR,[S]               'Set spindle RPM"
"C6                   'Spindle on"
"PAUSE 2"
"MS,[FC],[FP]"
"JZ,[ZH]"
begin NEW_SEGMENT
"'New Path"
"'Toolpath Name = [TOOLPATH_NAME]"
"MS,[FC],[FP]"
begin TOOLCHANGE
"'Toolpath Name = [TOOLPATH_NAME]"
"&Tool =[T]           'Tool number to change to"
"C9                   'Change tool"
"TR,[S]               'Set spindle RPM"
"C6                   'Spindle on"
"PAUSE 2"
begin FIRST_RAPID_MOVE
"J3,[X],[Y],"
begin RAPID_MOVE
"J3,[X],[Y],[Z]"
begin FEED_MOVE
"M3,[X],[Y],[Z]"
begin CW_ARC_MOVE
"CG, ,[X],[Y],[I],[J],T,1"
begin CCW_ARC_MOVE
"CG, ,[X],[Y],[I],[J],T,-1"
begin FOOTER
"JZ,[ZH]"
"J2,[XH],[YH]"
"C7"
"END"
"UNIT_ERROR:"
"CN, 91                            'Run file explaining unit error"
"END"
