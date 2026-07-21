# Best-effort update of a git checkout to origin/master.
# Network failures must NOT fail the build: offline builds keep using the
# existing checkout that FetchContent already populated.
#
# Inputs:
#   GIT_EXECUTABLE - path to git
#   REPO_DIR       - working directory of the checkout
#   REMOVE_FILE    - optional file to delete afterwards (e.g. QuickJS VERSION)

execute_process(
    COMMAND ${GIT_EXECUTABLE} fetch --depth=1 origin master
    WORKING_DIRECTORY ${REPO_DIR}
    RESULT_VARIABLE fetch_result
    ERROR_VARIABLE fetch_error
)

if(fetch_result EQUAL 0)
    execute_process(
        COMMAND ${GIT_EXECUTABLE} reset --hard FETCH_HEAD
        WORKING_DIRECTORY ${REPO_DIR}
        RESULT_VARIABLE reset_result
    )
    if(NOT reset_result EQUAL 0)
        message(WARNING "git reset failed in ${REPO_DIR}; using existing checkout")
    endif()
else()
    message(WARNING "git fetch failed in ${REPO_DIR} (offline?): ${fetch_error} -- using existing checkout")
endif()

if(REMOVE_FILE)
    execute_process(COMMAND ${CMAKE_COMMAND} -E rm -f "${REMOVE_FILE}")
endif()
